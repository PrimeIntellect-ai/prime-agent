//! Codex WebSocket session state: connection cache, SSE-fallback pinning,
//! debug stats, continuation bookkeeping, and idle expiry. Section of the
//! port of `packages/ai/src/providers/openai-codex-responses.ts`.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tokio::sync::mpsc;

use serde_json::Value;

use crate::providers::openai_codex_responses::errors::CodexStreamError;
use crate::providers::openai_codex_responses::websocket::{
    ContinuationState, WorkerCommand, SESSION_WEBSOCKET_CACHE_TTL_MS,
};

pub use crate::providers::openai_codex_responses::websocket::WebSocketDebugStats;

pub struct CachedConnection {
    /// Command channel to the connection's worker task.
    pub worker: mpsc::Sender<WorkerCommand>,
    pub busy: bool,
    pub continuation: Option<ContinuationState>,
    /// Generation counter for pending idle-expiry tasks.
    pub expiry_generation: u64,
    /// Unique id of this connection (monotonic).
    pub connection_id: u64,
}

#[derive(Default)]
pub struct SessionState {
    pub connections: HashMap<String, CachedConnection>,
    pub stats: HashMap<String, WebSocketDebugStats>,
    pub sse_fallback_sessions: HashSet<String>,
}

pub fn session_state() -> &'static Mutex<SessionState> {
    static STATE: OnceLock<Mutex<SessionState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(SessionState::default()))
}

/// Port of `isWebSocketSseFallbackActive`.
pub fn is_websocket_sse_fallback_active(session_id: Option<&str>) -> bool {
    match session_id {
        Some(session_id) => session_state()
            .lock()
            .is_ok_and(|state| state.sse_fallback_sessions.contains(session_id)),
        None => false,
    }
}

/// Port of `recordWebSocketSseFallback`.
pub fn record_websocket_sse_fallback(session_id: Option<&str>) {
    let Some(session_id) = session_id else {
        return;
    };
    let Ok(mut state) = session_state().lock() else {
        return;
    };
    let active = state.sse_fallback_sessions.contains(session_id);
    let stats = state.stats.entry(session_id.to_string()).or_default();
    stats.sse_fallbacks += 1;
    stats.websocket_fallback_active = Some(active);
}

/// Port of `recordWebSocketFailure`: pins the session to SSE fallback and
/// records the failure in the debug stats.
/// Port of `recordWebSocketFailure`: pins the session to SSE fallback and
/// records the failure in the debug stats.
pub fn record_websocket_failure(session_id: Option<&str>, error: &CodexStreamError) {
    let Some(session_id) = session_id else {
        return;
    };
    let Ok(mut state) = session_state().lock() else {
        return;
    };
    state.sse_fallback_sessions.insert(session_id.to_string());
    let stats = state.stats.entry(session_id.to_string()).or_default();
    stats.websocket_failures += 1;
    stats.last_websocket_error = Some(error.to_string());
    stats.websocket_fallback_active = Some(true);
}

/// Port of `getOpenAICodexWebSocketDebugStats`.
pub fn get_debug_stats(session_id: &str) -> Option<WebSocketDebugStats> {
    session_state().lock().ok()?.stats.get(session_id).cloned()
}

/// Port of `resetOpenAICodexWebSocketDebugStats`.
pub fn reset_debug_stats(session_id: Option<&str>) {
    let Ok(mut state) = session_state().lock() else {
        return;
    };
    if let Some(session_id) = session_id {
        state.stats.remove(session_id);
        state.sse_fallback_sessions.remove(session_id);
    } else {
        state.stats.clear();
        state.sse_fallback_sessions.clear();
    }
}

/// Port of `closeOpenAICodexWebSocketSessions`: close the cached connection
/// for one session or all of them. The TS registers this as a session
/// resource cleanup; in Rust the agent layer calls it when a session ends.
/// Port of `closeOpenAICodexWebSocketSessions`: close the cached connection
/// for one session or all of them. The TS registers this as a session
/// resource cleanup; in Rust the agent layer calls it when a session ends.
pub fn close_websocket_sessions(session_id: Option<&str>) {
    let Ok(mut state) = session_state().lock() else {
        return;
    };
    let entries: Vec<mpsc::Sender<WorkerCommand>> = match session_id {
        Some(session_id) => state
            .connections
            .remove(session_id)
            .map(|entry| vec![entry.worker])
            .unwrap_or_default(),
        None => state
            .connections
            .drain()
            .map(|(_, entry)| entry.worker)
            .collect(),
    };
    for worker in entries {
        let _ = worker.try_send(WorkerCommand::Close);
    }
}

/// Record debug stats for a request (mirrors the stats block in
/// `processWebSocketStream`).
/// Record debug stats for a request (mirrors the stats block in
/// `processWebSocketStream`).
pub fn record_request_stats(
    session_id: &str,
    reused: bool,
    use_cached_context: bool,
    request_body: &Value,
) {
    let Ok(mut state) = session_state().lock() else {
        return;
    };
    let stats = state.stats.entry(session_id.to_string()).or_default();
    stats.requests += 1;
    if reused {
        stats.connections_reused += 1;
    } else {
        stats.connections_created += 1;
    }
    if use_cached_context {
        stats.cached_context_requests += 1;
    }
    if request_body.get("store").and_then(Value::as_bool) == Some(true) {
        stats.store_true_requests += 1;
    }
    let input_items = request_body
        .get("input")
        .and_then(Value::as_array)
        .map_or(0, |items| items.len() as u64);
    stats.last_input_items = input_items;
    if let Some(previous_response_id) = request_body
        .get("previous_response_id")
        .and_then(Value::as_str)
    {
        stats.delta_requests += 1;
        stats.last_delta_input_items = Some(input_items);
        stats.last_previous_response_id = Some(previous_response_id.to_string());
    } else {
        stats.full_context_requests += 1;
        stats.last_delta_input_items = None;
        stats.last_previous_response_id = None;
    }
}

/// Port of `acquireWebSocket`: reuse the session's idle connection when
/// possible, otherwise open a fresh connection (cached per session).
/// Port of `scheduleSessionWebSocketExpiry`: close the cached connection
/// after the TTL if it stayed idle.
pub fn schedule_session_websocket_expiry(session_id: &str) {
    let Ok(mut state) = session_state().lock() else {
        return;
    };
    let generation = match state.connections.get_mut(session_id) {
        Some(entry) => {
            entry.expiry_generation += 1;
            entry.expiry_generation
        }
        None => return,
    };
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(SESSION_WEBSOCKET_CACHE_TTL_MS)).await;
        let Ok(mut state) = session_state().lock() else {
            return;
        };
        let Some(entry) = state.connections.get_mut(&session_id) else {
            return;
        };
        if entry.expiry_generation != generation || entry.busy {
            return;
        }
        if let Some(entry) = state.connections.remove(&session_id) {
            let _ = entry.worker.try_send(WorkerCommand::Close);
        }
    });
}

/// Take the continuation for `connection_id`, if one is anchored to it
/// (part of `buildCachedWebSocketRequestBody` in the TS).
/// Take the continuation for `connection_id`, if one is anchored to it
/// (part of `buildCachedWebSocketRequestBody` in the TS).
pub fn take_continuation_for(session_id: &str, connection_id: u64) -> Option<ContinuationState> {
    session_state()
        .lock()
        .ok()?
        .connections
        .get_mut(session_id)
        .filter(|entry| entry.connection_id == connection_id)
        .and_then(|entry| entry.continuation.take())
}

/// Restore (or clear) the continuation after a failed continuation attempt.
pub fn clear_continuation(session_id: &str, connection_id: u64) {
    let Ok(mut state) = session_state().lock() else {
        return;
    };
    if let Some(entry) = state.connections.get_mut(session_id) {
        if entry.connection_id == connection_id {
            entry.continuation = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::openai_codex_responses::errors::WebSocketTransportError;

    #[test]
    fn sse_fallback_lifecycle() {
        let session = format!("test-session-{}", std::process::id());
        reset_debug_stats(Some(&session));
        assert!(!is_websocket_sse_fallback_active(Some(&session)));
        // Recording a fallback bump does not pin the session (only a
        // transport failure does, matching the TS semantics).
        record_websocket_sse_fallback(Some(&session));
        assert!(!is_websocket_sse_fallback_active(Some(&session)));
        let stats = get_debug_stats(&session).expect("stats recorded");
        assert_eq!(stats.sse_fallbacks, 1);
        assert_eq!(stats.websocket_fallback_active, Some(false));
        reset_debug_stats(Some(&session));
        assert!(get_debug_stats(&session).is_none());
        assert!(!is_websocket_sse_fallback_active(Some(&session)));
    }

    #[tokio::test]
    async fn records_failure_and_pins_fallback() {
        let session = format!("failure-session-{}", std::process::id());
        reset_debug_stats(Some(&session));
        record_websocket_failure(
            Some(&session),
            &CodexStreamError::Transport(WebSocketTransportError::runtime("boom")),
        );
        assert!(is_websocket_sse_fallback_active(Some(&session)));
        let stats = get_debug_stats(&session).expect("stats recorded");
        assert_eq!(stats.websocket_failures, 1);
        assert_eq!(stats.last_websocket_error.as_deref(), Some("boom"));
        close_websocket_sessions(Some(&session));
        reset_debug_stats(Some(&session));
    }
}
