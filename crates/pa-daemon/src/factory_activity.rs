//! The `factory_activity` worker arm: the `/factory` view's daemon lane.

//! One session-addressed command reaches this session's kernel factory
//! executor (the bridge registered by the pa-core session engine): the
//! payload's `action` rides the out-of-band kernel frame, and the kernel's
//! reply returns verbatim (the run registry stays kernel-owned). The
//! `run` action's model preflight (the allowlist pin, request auth)
//! happens in the session engine before the frame — a doomed run fails
//! before any child spawns.

use serde_json::Value;

use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::worker::Worker;

impl Worker {
    /// `factory_activity`: one factory action over this session's kernel.
    /// The arm mirrors `handle_kernel_bash_activity`: the engine owns the
    /// kernel scope, and a missing session answers with the same "Kernel
    /// is not running" refusal.
    pub(crate) async fn handle_factory_activity(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("factory_activity") {
            return response;
        }
        let action = payload
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if action.is_empty() {
            return response_failure(None, "factory_activity", "action is required", None);
        }
        let run_id = payload
            .get("runId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let spec_id = payload
            .get("specId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let timeout_ms = payload.get("timeoutMs").and_then(Value::as_u64);
        let Some(engine) = &self.agent_engine else {
            return response_failure(None, "factory_activity", "Kernel is not running", None);
        };
        match engine
            .factory_activity(&action, run_id.as_deref(), spec_id.as_deref(), timeout_ms)
            .await
        {
            Ok(result) => response_success(None, "factory_activity", Some(result)),
            Err(error) => response_failure(None, "factory_activity", &format!("{error:#}"), None),
        }
    }
}
