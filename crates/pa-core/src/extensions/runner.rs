//! The facade the session engine sees (design doc §3.2 `runner.rs`): owns
//! one extension sidecar host plus the registry, and exposes the stage-2
//! surface: registration views, `has_handlers` gating, tool execution over
//! RPC, and the bridged loop tools.
//!
//! The TS counterpart is `ExtensionRunner` (extensions/runner.ts): there the
//! extensions and their live objects sit in-process; here the sidecar owns
//! the live half and this runner mirrors the registrations. Emission at the
//! session-engine seams, ctx-action binding, stale-ctx invalidation, and
//! host timers on the Rust side are later stages; stage 2 lands the runner
//! with registration + tool execution.

use anyhow::Result;
use pa_agent::types::AgentTool;
use pa_types::extension_rpc::{
    CommandExecuteParams, HelloResult, ShortcutExecuteParams, ToolExecuteResult,
    METHOD_COMMAND_EXECUTE, METHOD_SHORTCUT_EXECUTE,
};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, warn};

use super::client::SidecarNotification;
use super::host::{ExtensionHost, ExtensionHostSpec, HostTimeouts};
use super::registry::{ExtensionRegistry, ResolvedExtensionCommand};
use super::tool::ExtensionTool;

/// One extension world: a sidecar host plus the registry mirror.
pub struct ExtensionRunner {
    host: ExtensionHost,
    registry: Arc<Mutex<ExtensionRegistry>>,
    timeouts: HostTimeouts,
}

impl ExtensionRunner {
    /// Spawn the sidecar, run the `hello` load cycle, and land the
    /// registrations. Load errors are carried in the runner (never fatal,
    /// TS parity: `loadExtensions` reports them per-path).
    pub async fn start(spec: ExtensionHostSpec) -> Result<ExtensionRunner> {
        let mut host = ExtensionHost::start(spec.clone()).await?;
        let registry = Arc::new(Mutex::new(ExtensionRegistry::default()));
        // Pump sidecar notifications for the runner's lifetime:
        // post-hello registration changes merge into the registry;
        // extension_error reports surface as warnings (they are already
        // non-fatal in the sidecar's error boundary).
        let pump_registry = Arc::clone(&registry);
        let mut notifications = host.take_notifications();
        tokio::spawn(async move {
            while let Some(notification) = notifications.recv().await {
                match notification {
                    SidecarNotification::Registration(registration) => {
                        pump_registry
                            .lock()
                            .await
                            .merge_notification(registration.registration);
                    }
                    SidecarNotification::ExtensionError(error) => {
                        warn!(
                            target: "extension_host",
                            "extension error ({} on {}): {}",
                            error.extension_path,
                            error.event,
                            error.error
                        );
                    }
                    SidecarNotification::Other { method, params } => {
                        debug!(
                            target: "extension_host",
                            "sidecar notification {method}: {params}"
                        );
                    }
                }
            }
        });
        registry.lock().await.merge_load(&host.hello().extensions);
        Ok(ExtensionRunner {
            host,
            registry,
            timeouts: spec.timeouts,
        })
    }

    /// The handshake result: registrations as loaded plus per-path errors.
    pub fn hello(&self) -> &HelloResult {
        self.host.hello()
    }

    /// Per-path load errors (never fatal; surfaced by the caller in
    /// startup notices).
    pub fn load_errors(&self) -> &[pa_types::extension_rpc::ExtensionLoadError] {
        &self.host.hello().errors
    }

    /// The registration views through the registry mirror (TS collision
    /// rules). The registry lives behind a mutex because the notification
    /// pump merges post-hello registration changes; every view re-derives
    /// from the same registration list.
    pub async fn registry(&self) -> tokio::sync::MutexGuard<'_, ExtensionRegistry> {
        self.registry.lock().await
    }

    /// Whether the runner is still usable (§2.4: a dead sidecar degrades to
    /// no-ops; requests fail fast).
    pub fn is_alive(&self) -> bool {
        self.host.is_alive()
    }

    /// The sidecar process id (diagnostics and tests).
    pub fn pid(&self) -> Option<u32> {
        self.host.pid()
    }

    /// Whether any loaded extension subscribed to `event` (runner.ts
    /// `hasHandlers` gating).
    pub async fn has_handlers(&self, event: &str) -> bool {
        self.registry.lock().await.has_handlers(event)
    }

    /// Registered commands with invocation names (collision suffixing).
    pub async fn commands(&self) -> Vec<ResolvedExtensionCommand> {
        self.registry.lock().await.commands()
    }

    /// Dispatch one event; the reply carries the accumulated handler
    /// result (chaining semantics land with the event-surface stage).
    pub async fn emit_event(
        &self,
        event_type: &str,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value> {
        self.host.emit_event(event_type, payload).await
    }

    /// Execute a registered extension tool by name (used directly by tests
    /// and the tool bridge's fallback paths).
    pub async fn execute_tool(
        &self,
        tool_call_id: &str,
        tool_name: &str,
        args: serde_json::Value,
    ) -> Result<ToolExecuteResult> {
        self.host.execute_tool(tool_call_id, tool_name, args).await
    }

    /// Dispatch a slash command by invocation name.
    pub async fn execute_command(&self, invocation_name: &str, args: &str) -> Result<()> {
        let params = serde_json::to_value(CommandExecuteParams {
            invocation_name: invocation_name.to_string(),
            args: args.to_string(),
        })?;
        self.host_request(METHOD_COMMAND_EXECUTE, params).await?;
        Ok(())
    }

    /// Dispatch a keybinding shortcut by normalized key id.
    pub async fn execute_shortcut(&self, key: &str) -> Result<()> {
        let params = serde_json::to_value(ShortcutExecuteParams {
            key: key.to_string(),
        })?;
        self.host_request(METHOD_SHORTCUT_EXECUTE, params).await?;
        Ok(())
    }

    /// The loop-visible tools: every registered extension tool bridged over
    /// the RPC, filtered by the optional name allow-list (`--tools`, TS
    /// `isAllowedTool`: an absent list allows everything).
    /// The loop-visible tools: every registered extension tool bridged over
    /// the RPC, filtered by the optional name allow-list (`--tools`, TS
    /// `isAllowedTool`: an absent list allows everything).
    pub async fn bridge_tools(&self, allow_list: Option<&[String]>) -> Vec<Arc<dyn AgentTool>> {
        let registrations: Vec<_> = self
            .registry
            .lock()
            .await
            .tools()
            .into_iter()
            .cloned()
            .collect();
        let client = self.host.client().clone();
        registrations
            .into_iter()
            .filter(|tool| {
                allow_list
                    .map(|allowed| allowed.iter().any(|name| name == &tool.name))
                    .unwrap_or(true)
            })
            .map(|tool| {
                Arc::new(ExtensionTool::new(tool, client.clone(), self.timeouts.rpc))
                    as Arc<dyn AgentTool>
            })
            .collect()
    }

    /// Liveness probe (Rust-side `ping`).
    pub async fn ping(&self) -> Result<serde_json::Value> {
        self.host.ping().await
    }

    /// Orderly shutdown (§2.4): `shutdown` -> emit `session_shutdown` in the
    /// sidecar -> wait briefly -> kill the process group.
    pub async fn shutdown(self, reason: &str) -> Result<()> {
        self.host.shutdown(reason).await
    }

    async fn host_request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        self.host
            .client()
            .request(method, params, self.timeouts.rpc)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::RpcClient;
    use pa_agent::types::ToolExecutionMode;
    use pa_types::extension_rpc::ToolRegistration;
    use serde_json::json;
    use std::time::Duration;

    fn registration(name: &str, mode: Option<&str>) -> ToolRegistration {
        ToolRegistration {
            name: name.to_string(),
            label: name.to_string(),
            description: "test".to_string(),
            prompt_snippet: None,
            prompt_guidelines: None,
            parameters: json!({"type": "object"}),
            execution_mode: mode.map(str::to_string),
        }
    }

    #[test]
    fn extension_tool_maps_registration_to_the_loop_contract() {
        let tool = registration("hello", Some("sequential"));
        let bridge = ExtensionTool::new(
            tool,
            RpcClient::new(
                tokio::io::sink(),
                tokio::sync::mpsc::channel(1).0,
                None,
                super::super::framing::LineLimits::default(),
            ),
            Duration::from_secs(1),
        );
        assert_eq!(bridge.name(), "hello");
        assert_eq!(bridge.label(), "hello");
        assert_eq!(bridge.description(), "test");
        assert_eq!(bridge.execution_mode(), Some(ToolExecutionMode::Sequential));
        assert_eq!(bridge.parameters(), &json!({"type": "object"}));
        assert!(bridge.prepare_arguments(&json!({})).is_none());
    }

    #[test]
    fn execution_mode_absent_and_unknown_map_to_none() {
        let none = ExtensionTool::new(
            registration("a", None),
            RpcClient::new(
                tokio::io::sink(),
                tokio::sync::mpsc::channel(1).0,
                None,
                super::super::framing::LineLimits::default(),
            ),
            Duration::from_secs(1),
        );
        assert_eq!(none.execution_mode(), None);
        let unknown = ExtensionTool::new(
            registration("b", Some("weird")),
            RpcClient::new(
                tokio::io::sink(),
                tokio::sync::mpsc::channel(1).0,
                None,
                super::super::framing::LineLimits::default(),
            ),
            Duration::from_secs(1),
        );
        assert_eq!(unknown.execution_mode(), None);
    }
}
