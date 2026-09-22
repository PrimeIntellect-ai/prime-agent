//! The worker arm behind the `get_mcp_connections` command: the roster
//! the interactive client's `/mcp` connections view renders — every
//! configured connection (built-in catalog plus user-declared servers)
//! with its connected state, plus the per-server tool listing the session
//! kernel reports for the generic servers (the runtime `mcp_status`
//! request, bounded per server).

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::worker::Worker;

/// Per-server budget for the kernel tool listing: a server that cannot
/// finish its handshake inside it reports its error entry instead of
/// stalling the view (the listing opens each not-yet-connected server).
pub(crate) const MCP_TOOL_LISTING_TIMEOUT_MS: u64 = 8_000;

/// How long the listing waits for the built session: the create-time
/// build races the first demand seam (the kernel prewarm starts at
/// create, the session slot fills when the build commits), and a running
/// turn holds the session mutex across its admission — the view answers
/// the roster alone (with the tools marked unavailable) instead of
/// queuing past this bound.
const SESSION_BUILD_WAIT: std::time::Duration = std::time::Duration::from_secs(12);

/// The poll interval while the create-time session build is in flight.
const SESSION_BUILD_POLL: std::time::Duration = std::time::Duration::from_millis(200);

impl Worker {
    /// `get_mcp_connections`: the roster from the session's MCP manager
    /// (auth gating over settings plus the built-in catalog), overlaid
    /// with the kernel's tool listing for every connected generic server.
    /// The listing waits out the create-time session build (bounded); a
    /// running turn holds the session past the bound, and the view then
    /// answers the roster alone with the tools marked unavailable.
    pub(crate) async fn handle_get_mcp_connections(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_mcp_connections") {
            return response;
        }
        let Some(manager) = self.engine.acp_mcp_manager() else {
            return response_failure(
                None,
                "get_mcp_connections",
                "MCP connections are not available in this session",
                None,
            );
        };
        // The roster read gates through the auth store, whose snapshot
        // takes a blocking lock (the pa-daemon test harnesses use the same
        // spawn_blocking shape for `list_status`) — never on the runtime.
        let roster_manager = std::sync::Arc::clone(&manager);
        let roster = match tokio::task::spawn_blocking(move || {
            let manager = roster_manager.lock().unwrap();
            manager.connection_roster()
        })
        .await
        {
            Ok(roster) => roster,
            Err(error) => {
                return response_failure(
                    None,
                    "get_mcp_connections",
                    &format!("MCP roster read failed: {error}"),
                    None,
                );
            }
        };
        // The servers whose tools the kernel can list: connected generic
        // servers (the built-in catalog surfaces through integration
        // skills, not the generic `mcp.list_tools` API).
        let listable: Vec<String> = roster
            .iter()
            .filter(|entry| entry.connected && entry.generic)
            .map(|entry| entry.server.clone())
            .collect();
        let mut listing: HashMap<String, Value> = HashMap::new();
        if !listable.is_empty() {
            if let Some(agent_engine) = self.agent_engine.as_ref() {
                // The session builds eagerly at create but commits to its
                // slot when the build finishes (the kernel prewarm races
                // it); a running turn holds the slot's mutex across its
                // admission. Wait out the build window — bounded, so the
                // view never queues behind a long turn — then list
                // through the built session's kernel.
                let deadline = std::time::Instant::now() + SESSION_BUILD_WAIT;
                let session = loop {
                    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                    if remaining.is_zero() {
                        break None;
                    }
                    match tokio::time::timeout(remaining, agent_engine.session.lock()).await {
                        // The mutex is held past the bound (a running
                        // turn): the roster answers alone.
                        Err(_) => break None,
                        Ok(session) if session.is_some() => break Some(session),
                        Ok(session) => {
                            drop(session);
                            tokio::time::sleep(SESSION_BUILD_POLL).await;
                        }
                    }
                };
                if let Some(session) = session {
                    if let Some(session) = session.as_ref() {
                        if let Some(connections) = session
                            .mcp_tool_listing(&listable, MCP_TOOL_LISTING_TIMEOUT_MS)
                            .await
                        {
                            for connection in connections {
                                if let Some(server) =
                                    connection.get("server").and_then(Value::as_str)
                                {
                                    listing.insert(server.to_string(), connection);
                                }
                            }
                        }
                    }
                }
            }
        }
        let connections: Vec<Value> = roster
            .into_iter()
            .map(|entry| {
                let mut value = serde_json::to_value(&entry).unwrap_or(Value::Null);
                let (tools, error) = match listing.get(&entry.server) {
                    Some(connection) => (
                        connection.get("tools").cloned().unwrap_or(Value::Null),
                        connection.get("error").cloned().unwrap_or(Value::Null),
                    ),
                    // No listing entry: either the server is not listable
                    // (skills-based built-in, or disconnected) or the
                    // listing was unavailable (no kernel yet, session busy).
                    None => (Value::Null, Value::Null),
                };
                value["tools"] = tools;
                value["error"] = error;
                value
            })
            .collect();
        // The resolved service catalog (the `/mcp` view's discovery rows):
        // every resolved service plus user-declared servers, connected-first.
        // The roster read gates through the auth store like the roster above
        // (spawn_blocking), then the tool listings for connected services.
        let (services, diagnostics) = match tokio::task::spawn_blocking(move || {
            let manager = manager.lock().unwrap();
            (
                manager.service_catalog_views(),
                manager.service_catalog_diagnostics().to_vec(),
            )
        })
        .await
        {
            Ok((services, diagnostics)) => (
                serde_json::to_value(&services).unwrap_or(Value::Array(Vec::new())),
                diagnostics,
            ),
            Err(error) => (
                Value::Array(Vec::new()),
                vec![format!("MCP service catalog read failed: {error}")],
            ),
        };
        response_success(
            None,
            "get_mcp_connections",
            Some(json!({
                "connections": connections,
                "services": services,
                "catalogDiagnostics": diagnostics,
            })),
        )
    }

    /// `set_mcp_static_token`: the inline paste flow's install step. Stores
    /// the credential bound to the service endpoint (the pin), verifies with
    /// a real handshake, and persists the connection record.
    pub(crate) async fn handle_set_mcp_static_token(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("set_mcp_static_token") {
            return response;
        }
        let Some(server) = payload.get("server").and_then(Value::as_str) else {
            return response_failure(
                None,
                "set_mcp_static_token",
                "set_mcp_static_token requires a server",
                None,
            );
        };
        let Some(token) = payload.get("token").and_then(Value::as_str) else {
            return response_failure(
                None,
                "set_mcp_static_token",
                "set_mcp_static_token requires a token",
                None,
            );
        };
        let Some(manager) = self.engine.acp_mcp_manager() else {
            return response_failure(
                None,
                "set_mcp_static_token",
                "MCP connections are not available in this session",
                None,
            );
        };
        // Gather under a short manager lock; the install (credential store +
        // handshake probe) awaits without holding it.
        let inputs = {
            let manager = manager.lock().unwrap();
            manager.paste_install_inputs(server)
        };
        let install = match inputs {
            Ok(inputs) => pa_core::mcp::install_static_token(inputs, token).await,
            Err(message) => Err(message),
        };
        if install.is_ok() {
            let manager = manager.lock().unwrap();
            manager.note_usage("paste-install", server);
        }
        match install {
            Ok(outcome) => response_success(
                None,
                "set_mcp_static_token",
                Some(json!({
                    "server": server,
                    "endpoint": outcome.endpoint,
                    "verified": outcome.verified,
                    "toolCount": outcome.tool_count,
                    "error": outcome.error,
                })),
            ),
            Err(message) => response_failure(None, "set_mcp_static_token", &message, None),
        }
    }

    /// `remove_mcp_connection`: remove one connection's credential and its
    /// connection record (the durable endpoint pin) in one step — the
    /// view's remove-account action.
    pub(crate) async fn handle_remove_mcp_connection(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("remove_mcp_connection") {
            return response;
        }
        let Some(server) = payload.get("server").and_then(Value::as_str) else {
            return response_failure(
                None,
                "remove_mcp_connection",
                "remove_mcp_connection requires a server",
                None,
            );
        };
        let Some(manager) = self.engine.acp_mcp_manager() else {
            return response_failure(
                None,
                "remove_mcp_connection",
                "MCP connections are not available in this session",
                None,
            );
        };
        let handles = {
            let manager = manager.lock().unwrap();
            manager.connection_handles()
        };
        match pa_core::mcp::remove_mcp_connection(&handles, server).await {
            Ok(removed) => response_success(
                None,
                "remove_mcp_connection",
                Some(json!({ "server": server, "removed": removed })),
            ),
            Err(message) => response_failure(None, "remove_mcp_connection", &message, None),
        }
    }
}
