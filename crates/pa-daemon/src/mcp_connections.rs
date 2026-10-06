//! The worker arm behind the `get_mcp_connections` command: the roster,
//! the resolved service catalog, and the api-key credential catalog the
//! interactive client's `/mcp` view renders — every configured connection
//! (built-in catalog plus user-declared servers) with its connected state,
//! the service-catalog cards and the stored-key credentials over the same
//! fresh local state (the TS picker builds both from local reads on every
//! open, never a kernel round-trip; connected rows carry their record-held
//! tool count).

use serde_json::{json, Value};

use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::worker::Worker;

impl Worker {
    /// `get_mcp_connections`: the roster from the session's MCP manager
    /// (auth gating over settings plus the built-in catalog), the resolved
    /// service-catalog views, and the api-key credential rows (the stored
    /// keys the `/mcp` view manages alongside the connections), from ONE
    /// fresh local read — the manager reloads the auth store and
    /// re-resolves its integrations and catalog first (TS
    /// `buildServiceCatalogViews` re-reads the store and re-resolves the
    /// catalog on every open), so an externally changed settings file, a
    /// record another process wrote, or a key the interactive client just
    /// stored is visible on the next open. The roster and credential reads
    /// gate through the auth store, whose snapshot takes a blocking lock —
    /// never on the runtime.
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
        let roster_manager = std::sync::Arc::clone(&manager);
        let (roster, services, credentials, diagnostics) =
            match tokio::task::spawn_blocking(move || {
                let mut manager = roster_manager.lock().unwrap();
                // The auth store re-read comes FIRST: the interactive client
                // stores the api-key credentials through its own storage
                // instance (the `/mcp` key flow runs client-side), so the
                // view's reads must reload the store to see them.
                manager.reload_auth_storage();
                manager.refresh();
                (
                    manager.connection_roster(),
                    manager.service_catalog_views(),
                    manager.api_key_credential_views(),
                    manager.service_catalog_diagnostics().to_vec(),
                )
            })
            .await
            {
                Ok(read) => read,
                Err(error) => {
                    return response_failure(
                        None,
                        "get_mcp_connections",
                        &format!("MCP roster read failed: {error}"),
                        None,
                    );
                }
            };
        let connections: Vec<Value> = roster
            .into_iter()
            .map(|entry| serde_json::to_value(&entry).unwrap_or(Value::Null))
            .collect();
        let services = serde_json::to_value(&services).unwrap_or(Value::Array(Vec::new()));
        let credentials = serde_json::to_value(&credentials).unwrap_or(Value::Array(Vec::new()));
        response_success(
            None,
            "get_mcp_connections",
            Some(json!({
                "connections": connections,
                "services": services,
                "credentials": credentials,
                "catalogDiagnostics": diagnostics,
            })),
        )
    }

    /// `set_mcp_static_token`: the inline paste flow's install step — store
    /// the endpoint-pinned credential, verify, persist the record.
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

    /// `remove_mcp_connection`: remove one connection's credential and
    /// record (the durable endpoint pin) in one step.
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
